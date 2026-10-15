import { useEffect, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';

import { onBack } from '@/lib/backGuard';

const FOCUSABLE = 'button, [role=button], [role=menuitem], input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * Something over the screen (a question, a sheet of actions): Escape and the back button close it before the
 * screen under it reacts, it takes the keyboard focus (its field first) and gives it back, and Tab stays in it.
 * Returns the ref for its outermost view.
 */
export function useModal(close: () => void) {
  const ref = useRef<View>(null);
  // What had the focus before: read while rendering, as a field's autoFocus takes it before any effect runs.
  const [before] = useState(() => (Platform.OS === 'web' && typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null));
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    const unBack = onBack(() => (closeRef.current(), true));
    if (Platform.OS !== 'web') return unBack;
    const el = ref.current as unknown as HTMLElement | null;
    const field = el?.querySelector<HTMLElement>('input, textarea');
    if (!field) el?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.hasAttribute('disabled') && x.getAttribute('aria-disabled') !== 'true');
      if (!items.length) return;
      const [first, last] = [items[0], items[items.length - 1]];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture: before the screen's own keys (the reader closes the document on Escape).
    window.addEventListener('keydown', onKey, true);
    return () => {
      unBack();
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected && !el?.contains(before)) before.focus({ preventScroll: true });
    };
  }, [before]);
  return ref;
}
