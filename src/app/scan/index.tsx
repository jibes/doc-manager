import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, View } from 'react-native';

import { goBack } from '@/components/ScreenHeader';
import { Toast } from '@/components/Toast';
import { useScan } from '@/scan/session';
import { Camera } from '@/scan/ui/Camera';
import { usePrefs } from '@/state/prefs';
import { Unsupported } from '@/scan/ui/Unsupported';

/** The camera. `retake`: the photo replaces that page's; `from=review`: closing goes back to the document. */
export default function ScanCamera() {
  const { retake, from } = useLocalSearchParams<{ retake?: string; from?: string }>();
  const scan = usePrefs((s) => s.scan);
  const setPrefs = usePrefs((s) => s.set);
  const restore = useScan((s) => s.restore);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => void restore(), [restore]);

  const close = useCallback(() => {
    if (retake || from === 'review') goBack();
    else if (useScan.getState().pages.length) router.replace('/scan/review');
    else goBack();
  }, [retake, from]);
  const crop = useCallback((id: string) => router.push({ pathname: '/scan/crop', params: { id } }), []);
  const retaken = useCallback(() => goBack(), []);
  const dismiss = useCallback(() => setMessage(null), []);

  if (Platform.OS !== 'web') return <Unsupported />;
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Camera
        deviceId={scan.cameraDeviceId}
        autoCapture={scan.autoCapture}
        defaultFilter={scan.defaultFilter}
        retakeId={retake ?? null}
        onAutoCapture={(autoCapture) => setPrefs({ scan: { ...scan, autoCapture } })}
        onClose={close}
        onCrop={crop}
        onRetaken={retaken}
        say={setMessage}
      />
      <Toast message={message} onDismiss={dismiss} />
    </View>
  );
}
