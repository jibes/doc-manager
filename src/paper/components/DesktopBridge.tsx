import { useEffect } from 'react';
import { Linking } from 'react-native';

import { t } from '@/core/i18n';
import { desktop } from '@/core/lib/desktop';
import { sayRoot } from './RootToast';

const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** The menu bar's commands, as the keys the page already answers (⌘Z, ⌘F, …). */
const KEYS: Record<string, { key: string; shift?: boolean }> = {
  scan: { key: 'n' },
  open: { key: 'o' },
  save: { key: 's' },
  print: { key: 'p' },
  undo: { key: 'z' },
  redo: { key: 'z', shift: true },
  find: { key: 'f' },
  goto: { key: 'k' },
  zoomIn: { key: '=' },
  zoomOut: { key: '-' },
  zoomReset: { key: '0' },
};

const editable = (el: Element | null) => !!el && (/^(INPUT|TEXTAREA)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);

/**
 * The desktop app's menu bar and its update check: a command chosen in the menu does what its key does (a field
 * being typed in undoes its own typing); a newer version is said, with where to get it.
 */
export function DesktopBridge() {
  useEffect(() => {
    if (!desktop) return;
    desktop.onMenu((name) => {
      const active = document.activeElement;
      if ((name === 'undo' || name === 'redo') && editable(active)) return void document.execCommand(name);
      const k = KEYS[name];
      if (!k) return;
      (active ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k.key, metaKey: mac, ctrlKey: !mac, shiftKey: !!k.shift, bubbles: true, cancelable: true }));
    });
    desktop.onUpdate(({ version, url }) => {
      if (!version || !url) return sayRoot(t.updateNone);
      sayRoot(t.updateAvailable(version), { label: t.updateGet, onPress: () => void Linking.openURL(url) });
    });
  }, []);
  return null;
}
