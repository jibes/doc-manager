import { Directory, File, Paths } from 'expo-file-system';

import type { DocRecord, LibraryRepo } from './types';

export * from './types';

const root = new Directory(Paths.document, 'library');
const coversDir = new Directory(root, 'covers');
const index = new File(root, 'index.json');

function ensureDirs() {
  root.create({ idempotent: true, intermediates: true });
  coversDir.create({ idempotent: true });
}

let cache: Map<string, DocRecord> | null = null;
let writeChain = Promise.resolve();

async function load(): Promise<Map<string, DocRecord>> {
  if (cache) return cache;
  ensureDirs();
  const list: DocRecord[] = index.exists ? JSON.parse(await index.text()) : [];
  cache = new Map(list.map((r) => [r.id, r]));
  return cache;
}

/** Serialized, atomic-ish write: temp file then move over the index. */
function flush() {
  writeChain = writeChain.then(async () => {
    const tmp = new File(root, 'index.tmp.json');
    tmp.write(JSON.stringify([...(cache ?? new Map()).values()]));
    if (index.exists) index.delete();
    await tmp.move(index);
  });
  return writeChain;
}

const pdf = (id: string) => new File(root, `${id}.pdf`);
const cover = (id: string) => new File(coversDir, `${id}.jpg`);

export const repo: LibraryRepo = {
  list: async () => [...(await load()).values()],
  async put(rec) {
    (await load()).set(rec.id, rec);
    await flush();
  },
  async remove(id) {
    (await load()).delete(id);
    for (const f of [pdf(id), cover(id)]) if (f.exists) f.delete();
    await flush();
  },
  async saveFile(id, data) {
    ensureDirs();
    if (typeof data !== 'string') throw new Error('Native import expects a file URI');
    await new File(data).copy(pdf(id));
  },
  async source(id) {
    const f = pdf(id);
    if (!f.exists) throw new Error('This document’s file is missing from storage.');
    return { kind: 'uri', uri: f.uri };
  },
  linkedTo: async () => new Map(),
  relink: async () => {},
  async saveCover(id, data) {
    if (typeof data !== 'string') throw new Error('Native covers are file URIs');
    const dest = cover(id);
    if (dest.exists) dest.delete();
    await new File(data).move(dest);
  },
  async coverUri(id) {
    const f = cover(id);
    return f.exists ? f.uri : null;
  },
  // Native keeps copies (opening in place needs security-scoped bookmarks / persisted SAF grants).
  requestAccess: async () => true,
  async writeFile(id, bytes) {
    pdf(id).write(new Uint8Array(bytes));
  },
  // No on-device OCR on native yet (see src/ocr), so nothing is ever stored.
  loadOcr: async (_id, pageCount) => new Array(pageCount).fill(undefined),
  saveOcr: async () => {},
};
