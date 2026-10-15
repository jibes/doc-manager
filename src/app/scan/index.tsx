import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Platform, View } from 'react-native';

import { goBack } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { pausePrefetch, resumePrefetch } from '@/scan/exportCache';
import { sayScan, useScan, useScanMessage } from '@/scan/session';
import { Camera } from '@/scan/ui/Camera';
import { usePrefs } from '@/state/prefs';
import { Unsupported } from '@/scan/ui/Unsupported';

/** The camera. `retake`: the photo replaces that page's; `from=review`: closing goes back to the document. */
export default function ScanCamera() {
  const { retake, from } = useLocalSearchParams<{ retake?: string; from?: string }>();
  const scan = usePrefs((s) => s.scan);
  const setPrefs = usePrefs((s) => s.set);
  const restore = useScan((s) => s.restore);
  const message = useScanMessage((s) => s.text);
  const focused = useIsFocused();
  useEffect(() => void restore(), [restore]);
  // While the camera is in front, page detection has the processor: the document's pages aren't prepared meanwhile.
  useEffect(() => {
    if (!focused) return;
    pausePrefetch();
    return resumePrefetch;
  }, [focused]);

  const close = useCallback(() => {
    if (retake || from === 'review') goBack();
    else if (useScan.getState().pages.length) router.replace('/scan/review');
    else goBack();
  }, [retake, from]);
  const crop = useCallback((id: string) => router.push({ pathname: '/scan/crop', params: { id } }), []);
  const retaken = useCallback(() => goBack(), []);
  const say = useCallback((text: string) => sayScan(text), []);
  const dismiss = useCallback(() => sayScan(null), []);

  if (Platform.OS !== 'web') return <Unsupported />;
  return (
    <View style={{ flex: 1, backgroundColor: '#000', userSelect: 'none' } as object}>
      <Camera
        deviceId={scan.cameraDeviceId}
        autoCapture={scan.autoCapture}
        defaultFilter={scan.defaultFilter}
        retakeId={retake ?? null}
        active={focused}
        onAutoCapture={(autoCapture) => setPrefs({ scan: { ...scan, autoCapture } })}
        onClose={close}
        onCrop={crop}
        onRetaken={retaken}
        say={say}
      />
      {focused && <Toast message={message} onDismiss={dismiss} />}
    </View>
  );
}
