import { File, Paths } from 'expo-file-system';

import type { DocSource } from '@/engine/types';

/** Native: books are files in the app's documents; images are shown as data URIs, covers as cache files. */
export async function readBytes(src: DocSource): Promise<Uint8Array> {
  if (src.kind === 'bytes') return new Uint8Array(src.bytes);
  return new File(src.uri).bytes();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}

export function imageUri(bytes: Uint8Array, type: string): string {
  return `data:${type};base64,${base64(bytes)}`;
}

export function releaseImageUri(_uri: string) {}

/** The library stores covers from a file URI on native. */
export function coverData(bytes: Uint8Array, type: string): string {
  const f = new File(Paths.cache, `cover-${Date.now()}.${type.split('/')[1] ?? 'img'}`);
  f.write(bytes);
  return f.uri;
}
