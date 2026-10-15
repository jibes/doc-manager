import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { engine } from '@/engine';
import { itemsFromFiles } from '@/lib/pick';
import { claimShellFiles, fetchShellFiles, launchContents, openedWithFiles, shell, SHELL_OPEN_EVENT } from '@/lib/shell';
import { useLibrary } from '@/state/library';
import { usePalette } from '@/state/prefs';
import { t } from '@/i18n';
import { goTab } from './AppNav';
import { sayRoot } from './RootToast';

/** Long enough for the reader to have drawn its first frame under the cover. */
const SETTLE_MS = 250;

/** What came of files from another app: one document to show, several added to the library, or nothing. */
type Outcome = { show: string } | { added: number } | null;

/** Opens one file at once (it is shown as soon as it is open); several are added to the library. */
async function openFiles(files: Promise<File[]>): Promise<Outcome> {
  const items = itemsFromFiles(await files);
  const library = useLibrary.getState();
  if (items.length === 1) {
    const doc = await library.openIncoming(items[0]);
    return doc && { show: doc.id };
  }
  const added = items.length ? (await library.importFiles(items)).length : 0;
  return added ? { added } : null;
}

/**
 * Opened with a file: the engine starts, and the file is read and opened as soon as the app's code has
 * loaded, alongside its fonts and first screen, so the document is ready as soon as it can be shown.
 */
let atLaunch: Promise<Outcome> | null = openedWithFiles ? (engine.warm?.(), openFiles(launchContents()).catch(() => null)) : null;

/**
 * Android app: files opened or shared from other apps are added and opened. Until the reader is there, a
 * plain cover hides whatever screen is under it (at launch, the app's first screen), so it doesn't flash by.
 */
export function ShellOpen() {
  const p = usePalette();
  const [opening, setOpening] = useState(openedWithFiles);
  // Started on the bare screen for it: the document takes its place (back leads to the app that sent it).
  const path = usePathname();
  const startedBare = useRef(path === '/opening');
  // Where the app is when files arrive: a document being read isn't closed for several others.
  const where = useRef(path);
  useEffect(() => {
    where.current = path;
  }, [path]);

  useEffect(() => {
    if (!shell) return;
    const show = async (outcome: Promise<Outcome>) => {
      setOpening(true);
      const shown = async () => {
        const done = await outcome;
        const bare = startedBare.current;
        startedBare.current = false;
        if (done && 'show' in done) {
          const to = { pathname: '/read/[id]', params: { id: done.show } } as const;
          if (bare) router.replace(to);
          else router.push(to);
        } else if (done && !bare && where.current.startsWith('/read/')) sayRoot(t.filesAddedN(done.added));
        else if (done || bare) goTab('reading');
      };
      await shown().catch(() => {
        // Nothing opened: the screen under the cover is where the app is (or the app's first, from the bare one).
        if (startedBare.current) goTab('reading');
        startedBare.current = false;
      });
      setTimeout(() => setOpening(false), SETTLE_MS);
    };
    // Once (an effect can run twice).
    if (atLaunch) void show(atLaunch);
    atLaunch = null;
    const onOpen = () => {
      const list = claimShellFiles();
      if (list.length) void show(openFiles(fetchShellFiles(list)));
    };
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
