import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { ImportItem } from '@/state/library';

/** Native: files arrive via the picker or the share sheet, not drag-and-drop. */
export function DropZone({ children }: { children: ReactNode; onFiles: (items: ImportItem[]) => void }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
