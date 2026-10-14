import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { itemsFromFiles } from '@/lib/pick';
import { claimShellFiles, fetchShellFiles, launchFiles, shell, SHELL_OPEN_EVENT, type ShellFile } from '@/lib/shell';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { goTab } from './AppNav';

/** Long enough for the reader to have drawn its first frame under the cover. */
const SETTLE_MS = 250;

/**
 * Android app: files opened or shared from other apps are added and opened. Until the reader is there, a
 * plain cover hides whatever screen is under it (at launch, the app's first screen), so it doesn't flash by.
 */
export function ShellOpen() {
  const p = usePalette();
  const [opening, setOpening] = useState(launchFiles.length > 0);

  useEffect(() => {
    if (!shell) return;
    const open = async (list: ShellFile[]) => {
      if (!list.length) return;
      setOpening(true);
      try {
        const added = await useLibrary.getState().importFiles(itemsFromFiles(await fetchShellFiles(list)));
        if (added.length === 1) router.push({ pathname: '/read/[id]', params: { id: added[0].id } });
        else if (added.length) goTab('reading');
      } catch {
        // Nothing opened: the screen under the cover is where the app is.
      } finally {
        setTimeout(() => setOpening(false), SETTLE_MS);
      }
    };
    void open(launchFiles.splice(0));
    const onOpen = () => void open(claimShellFiles());
    window.addEventListener(SHELL_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SHELL_OPEN_EVENT, onOpen);
  }, []);

  if (!opening) return null;
  return (
    <View testID="opening" style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: p.canvas }]}>
      <ActivityIndicator color={p.muted} />
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { alignItems: 'center', justifyContent: 'center' },
});
