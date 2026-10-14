import { View } from 'react-native';

import { usePalette } from '@/state/prefs';

/**
 * Where the Android app starts when opened with a file (public/index.html sends it here): nothing to draw
 * but the background until the document is open (ShellOpen), so no other screen is built first.
 */
export default function Opening() {
  const p = usePalette();
  return <View style={{ flex: 1, backgroundColor: p.canvas }} />;
}
