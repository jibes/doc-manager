import { Asset } from 'expo-asset';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

import type { ImportItem } from '@/state/library';

export async function pickPdfs(): Promise<ImportItem[]> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  return res.assets.map((a) => ({ name: a.name, size: a.size ?? a.file?.size ?? 0, file: a.file, uri: a.uri }));
}

export async function sampleItem(): Promise<ImportItem> {
  const asset = Asset.fromModule(require('../../assets/samples/elements-of-reading.pdf'));
  const name = 'elements-of-reading.pdf';
  if (Platform.OS === 'web') {
    const file = await (await fetch(asset.uri)).blob();
    return { name, size: file.size, file };
  }
  await asset.downloadAsync();
  return { name, size: 0, uri: asset.localUri ?? asset.uri };
}

/** Web: files from drag-and-drop or the File Handling API. */
export function itemsFromFiles(files: Iterable<File>): ImportItem[] {
  return [...files]
    .filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    .map((f) => ({ name: f.name, size: f.size, file: f }));
}
