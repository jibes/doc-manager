import { useSyncExternalStore } from 'react';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type Kind = 'prompt' | 'ios' | null;

const EVENT = 'tessel:installable';
const w = () => window as unknown as { __installPrompt?: InstallPrompt | null };

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
// iPadOS reports as Mac; touch support tells them apart.
const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

function snapshot(): Kind {
  if (standalone()) return null;
  if (w().__installPrompt) return 'prompt';
  return ios() ? 'ios' : null;
}

function subscribe(cb: () => void) {
  addEventListener(EVENT, cb);
  const mq = matchMedia('(display-mode: standalone)');
  mq.addEventListener('change', cb);
  return () => {
    removeEventListener(EVENT, cb);
    mq.removeEventListener('change', cb);
  };
}

/**
 * 'prompt': Chromium offered installation (button triggers the native dialog).
 * 'ios': Safari has no prompt API; the caller explains Share → Add to Home Screen.
 * null: already installed or the browser can't install.
 */
export function useInstall(): { kind: Kind; install: () => Promise<boolean> } {
  const kind = useSyncExternalStore(subscribe, snapshot, () => null);
  const install = async () => {
    const p = w().__installPrompt;
    if (!p) return false;
    await p.prompt();
    const { outcome } = await p.userChoice;
    w().__installPrompt = null;
    dispatchEvent(new Event(EVENT));
    return outcome === 'accepted';
  };
  return { kind, install };
}
