import { Platform } from 'react-native';

import { t } from '@/i18n';

const web = Platform.OS === 'web' && typeof navigator !== 'undefined';
const mac = web && /Mac|iPhone|iPad/.test(navigator.platform);
// A phone or tablet without a keyboard has no use for shortcuts: only a fine pointer (mouse, trackpad) shows them.
const keyboard = web && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

/** How to write a shortcut with the command key here (⌘F, Ctrl+F, Strg+F), or undefined where there are none. */
export function shortcut(key: string): string | undefined {
  return keyboard ? `${mac ? '⌘' : t.ctrlKey}${key}` : undefined;
}

/** A label with a single-key shortcut in brackets (Text view (V)), when this device has shortcuts. */
export function withKey(label: string, key: string): string {
  return keyboard ? `${label} (${key})` : label;
}

/** A label with its shortcut in brackets, when this device has shortcuts. */
export function withShortcut(label: string, key: string): string {
  const k = shortcut(key);
  return k ? `${label} (${k})` : label;
}
