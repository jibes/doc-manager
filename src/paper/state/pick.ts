import { Asset } from 'expo-asset';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

import { SAMPLE_FILE, type ImportItem } from '@/paper/state/library';
import { canOpenInPlace, pickHandles, type FileHandle } from '@/core/lib/fsa';

export async function pickPdfs(): Promise<ImportItem[]> {
  // Chromium: link to the files where they are; elsewhere the library keeps a copy.
  if (canOpenInPlace()) return itemsFromHandles(await pickHandles());
  const res = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  return res.assets.map((a) => ({ name: a.name, size: a.size ?? a.file?.size ?? 0, file: a.file, uri: a.uri }));
}

export async function sampleItem(): Promise<ImportItem> {
  const asset = Asset.fromModule(require('../../../assets/samples/welcome-to-tessel.pdf'));
  const name = SAMPLE_FILE;
  if (Platform.OS === 'web') {
    const file = await (await fetch(asset.uri)).blob();
    return { name, size: file.size, file, bundled: true };
  }
  await asset.downloadAsync();
  return { name, size: 0, uri: asset.localUri ?? asset.uri };
}

/** What Tessel opens: PDFs. */
const isSupported = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

/** Web: files from drag-and-drop (handles where the browser gives them, for opening in place). */
export function itemsFromFiles(files: Iterable<File>, handles: (FileHandle | null)[] = []): ImportItem[] {
  return [...files]
    .map((f, i) => ({ name: f.name, size: f.size, file: f, handle: handles[i] ?? undefined }))
    .filter((it) => isSupported(it.file));
}

/** Web: picked handles, or files from the OS "Open with" (File Handling API). */
export async function itemsFromHandles(handles: FileHandle[]): Promise<ImportItem[]> {
  const files = await Promise.all(handles.map((h) => h.getFile()));
  return itemsFromFiles(files, handles);
}
