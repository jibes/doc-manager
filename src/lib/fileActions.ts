import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { repo, type DocRecord } from '@/storage';

/** Unsaved edits (web only for now: native can't edit yet). */
export type Current = () => Promise<ArrayBuffer> | undefined;

/** On native, "download" is the share sheet's Save to Files. */
export const canDownload = false;

/** The stored copy is named by id; share and print a copy carrying the original file name. */
async function namedCopy(doc: DocRecord): Promise<string> {
  const src = await repo.source(doc.id);
  if (src.kind !== 'uri') throw new Error('Expected a file URI');
  const dest = new File(Paths.cache, doc.fileName);
  if (dest.exists) dest.delete();
  await new File(src.uri).copy(dest);
  return dest.uri;
}

export async function shareDoc(doc: DocRecord, _current?: Current) {
  await Sharing.shareAsync(await namedCopy(doc), { ...(doc.format === 'epub' ? { mimeType: 'application/epub+zip', UTI: 'org.idpf.epub-container' } : { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' }), dialogTitle: doc.title });
}

export async function downloadDoc(doc: DocRecord, _current?: Current) {
  await shareDoc(doc);
}

export async function printDoc(doc: DocRecord, _current?: Current) {
  await Print.printAsync({ uri: await namedCopy(doc) });
}
