import type { DocSource } from '@/engine/types';

/** Web: book files and images live in memory; images are shown through object URLs. */
export async function readBytes(src: DocSource): Promise<Uint8Array> {
  return new Uint8Array(src.kind === 'bytes' ? src.bytes : await (await fetch(src.uri)).arrayBuffer());
}

export function imageUri(bytes: Uint8Array, type: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
}

export function releaseImageUri(uri: string) {
  URL.revokeObjectURL(uri);
}

/** The library stores covers as Blobs on web. */
export function coverData(bytes: Uint8Array, type: string): Blob {
  return new Blob([bytes as BlobPart], { type });
}
