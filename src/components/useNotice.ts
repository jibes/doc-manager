import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';

/** Undo for what a message reports: `undo` puts it back; `settle` runs once it can't be undone any more. */
export type Undo = { undo: () => void; settle?: () => void };

/**
 * The message a screen shows in its toast, maybe with Undo. Undo belongs to that message and goes with it (a new
 * message, the toast closing, the screen closing); what was left for it then is settled.
 */
export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  const say = useCallback((text: string | null, undo?: Undo) => {
    const settle = pending.current;
    pending.current = undo?.settle;
    settle?.();
    setNotice(text ? { text, undo: undo?.undo } : null);
  }, []);
  const dismiss = useCallback(() => say(null), [say]);
  useEffect(() => {
    const left = pending;
    return () => left.current?.();
  }, []);
  const undo = notice?.undo;
  const action = undo
    ? {
        label: t.undo,
        onPress: () => {
          pending.current = undefined;
          undo();
        },
      }
    : undefined;
  return { notice: notice?.text ?? null, say, dismiss, action };
}
