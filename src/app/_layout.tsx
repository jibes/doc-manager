import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Newsreader_400Regular } from '@expo-google-fonts/newsreader/400Regular';
import { Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader/400Regular_Italic';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader/500Medium';
import { Newsreader_600SemiBold } from '@expo-google-fonts/newsreader/600SemiBold';
import { useFonts } from 'expo-font';
import { router, Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ActionSheet } from '@/paper/components/ActionSheet';
import { AskDialog } from '@/paper/components/AskDialog';
import { DropZone } from '@/paper/components/DropZone';
import { PasswordDialog } from '@/paper/components/PasswordDialog';
import { RootToast, sayRoot } from '@/paper/components/RootToast';
import { DesktopBridge } from '@/paper/components/DesktopBridge';
import { ShellOpen } from '@/paper/components/ShellOpen';
import { desktop } from '@/core/lib/desktop';
import { log, setLogging, watchErrors } from '@/core/lib/log';
import { shell } from '@/core/lib/shell';
import { useAmbientLight } from '@/paper/state/ambient';
import { usePalette, usePrefs } from '@/paper/state/prefs';
import { schedule, startIndexing } from '@/paper/archive/indexer';
import { refreshInboxCount } from '@/paper/archive/inbox';
import { readAdded, resumeReading } from '@/paper/archive/intake';
import { showInPane } from '@/paper/state/pane';
import { t } from '@/core/i18n';
import { showInPicker } from '@/paper/archive/tessel';
import { useLibrary, type ImportItem } from '@/paper/state/library';
import { version } from '../../package.json';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Files dropped on the window: one is opened to look at; several are kept (there is nothing to show them in). */
async function dropped(items: ImportItem[]) {
  const library = useLibrary.getState();
  // Beside the list where there is room, as from Add.
  const open = async (id: string) => void ((await showInPane({ id })) || router.push({ pathname: '/read/[id]', params: { id } }));
  const doc = items.length === 1 ? await library.view(items[0]) : null;
  if (doc) return open(doc.id);
  const added = items.length > 1 ? await library.importFiles(items) : [];
  // Their text read as for files added (pages without any get theirs).
  readAdded(added);
  if (added.length === 1) await open(added[0].id);
  else if (added.length) sayRoot(t.filesAddedN(added.length));
}

/** The debug log: on as Settings says; errors (and where the app was) always. */
function useLog() {
  const on = usePrefs((s) => s.debugLog);
  useEffect(() => setLogging(on), [on]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    watchErrors({ version, app: shell ? 'android' : desktop ? 'desktop' : 'web', agent: navigator.userAgent, screen: `${screen.width}×${screen.height}@${devicePixelRatio}`, language: navigator.language });
  }, []);
  const path = usePathname();
  useEffect(() => log.info('nav', path), [path]);
}

export default function RootLayout() {
  useLog();
  const p = usePalette();
  useAmbientLight(usePrefs((s) => s.appearance) === 'auto');
  const [loaded, error] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Newsreader_400Regular,
    Newsreader_400Regular_Italic,
    Newsreader_500Medium,
    Newsreader_600SemiBold,
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  // Search across documents: the index is built in the background, and again when the library changes.
  useEffect(() => {
    // Every screen works with the library (opening, deleting, the reading list), whichever the app starts on.
    // Text left to read when the app last closed is read now, whichever screen it opens on.
    void useLibrary.getState().load().then(resumeReading);
    startIndexing();
    const unpicker = showInPicker();
    void refreshInboxCount();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refreshInboxCount());
    const unlibrary = useLibrary.subscribe((s, prev) => {
      if (s.docs.length !== prev.docs.length) schedule();
    });
    return () => (unpicker(), unlibrary());
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    document.documentElement.style.backgroundColor = p.canvas;
    document.documentElement.style.colorScheme = p.dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.canvas);
    // Android app: system bars take the same colour.
    shell?.theme(p.canvas, p.dark);
  }, [p]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: p.canvas }}>
      <StatusBar style={p.dark ? 'light' : 'dark'} />
      <DropZone onFiles={(items) => void dropped(items)}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: p.canvas },
            animation: 'fade_from_bottom',
          }}
        />
      </DropZone>
      <ShellOpen />
      <RootToast />
      <DesktopBridge />
      <PasswordDialog />
      <ActionSheet />
      <AskDialog />
    </GestureHandlerRootView>
  );
}
