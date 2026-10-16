import { Platform } from 'react-native';

/**
 * Going back, as the system does it: the Android app's back button and the browser's Back. A screen can
 * handle it first (close a panel, ask about unsaved edits) instead of being left at once.
 */
type Handler = () => boolean;
const handlers: Handler[] = [];
const web = Platform.OS === 'web' && typeof window !== 'undefined';

// The Android app asks before going back: true when the screen on top handled it.
if (web) (window as unknown as { __tesselBack?: () => boolean }).__tesselBack = () => handlers.at(-1)?.() ?? false;

/** `fn` handles the back button while registered (the last registered first); returns the unregister. */
export function onBack(fn: Handler): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.lastIndexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/**
 * Keeps the browser's Back on this page and calls `onBlocked` instead, until released. The page's first
 * script (public/index.html) asks `__tesselPopHold` before the router hears of the step back; the step forward
 * that undoes it is kept from the router too.
 */
export function holdBrowserBack(onBlocked: () => void): () => void {
  if (!web) return () => {};
  const w = window as unknown as { __tesselPopHold?: () => boolean };
  let undoing = false;
  const hold = () => {
    if (undoing) {
      undoing = false;
      return true;
    }
    undoing = true;
    window.history.go(1);
    onBlocked();
    return true;
  };
  w.__tesselPopHold = hold;
  return () => {
    if (w.__tesselPopHold === hold) w.__tesselPopHold = undefined;
  };
}
