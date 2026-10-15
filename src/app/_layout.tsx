import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Newsreader_400Regular } from '@expo-google-fonts/newsreader/400Regular';
import { Newsreader_400Regular_Italic } from '@expo-google-fonts/newsreader/400Regular_Italic';
import { Newsreader_500Medium } from '@expo-google-fonts/newsreader/500Medium';
import { Newsreader_600SemiBold } from '@expo-google-fonts/newsreader/600SemiBold';
import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ActionSheet } from '@/components/ActionSheet';
import { AskDialog } from '@/components/AskDialog';
import { DropZone } from '@/components/DropZone';
import { PasswordDialog } from '@/components/PasswordDialog';
import { ShellOpen } from '@/components/ShellOpen';
import { shell } from '@/lib/shell';
import { useAmbientLight } from '@/state/ambient';
import { usePalette, usePrefs } from '@/state/prefs';
import { schedule, startIndexing } from '@/archive/indexer';
import { startSharing } from '@/archive/sharing';
import { refreshInboxCount } from '@/archive/inbox';
import { useLibrary, type ImportItem } from '@/state/library';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Files dropped on the window (or opened with the app): into the library, and one of them opened. */
async function dropped(items: ImportItem[]) {
  const added = await useLibrary.getState().importFiles(items);
  if (added.length === 1) router.push({ pathname: '/read/[id]', params: { id: added[0].id } });
}

export default function RootLayout() {
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
    void useLibrary.getState().load();
    startIndexing();
    startSharing();
    void refreshInboxCount();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void refreshInboxCount());
    return useLibrary.subscribe((s, prev) => {
      if (s.docs.length !== prev.docs.length) schedule();
    });
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
      <PasswordDialog />
      <ActionSheet />
      <AskDialog />
    </GestureHandlerRootView>
  );
}
