import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@/core/i18n';

/** Undo for what a message reports: `undo` puts it back; `settle` runs once it can't be undone any more. */
export type Undo = { undo: () => void; settle?: () => void };

/**
 * The message a screen shows in its toast, maybe with Undo. Undo belongs to that message and goes with it (a new
 * message, the toast closing, the screen closing); what was left for it then is settled.
 */
export function useNotice() {
  const [notice, setNotice] = useState<{ text: string; undo?: () => void; id: number } | null>(null);
  const pending = useRef<(() => void) | undefined>(undefined);
  const say = useCallback((text: string | null, undo?: Undo) => {
    const settle = pending.current;
    pending.current = undo?.settle;
    settle?.();
    // Each message its own (the same words again too: its Undo gets its own time).
    setNotice((was) => (text ? { text, undo: undo?.undo, id: (was?.id ?? 0) + 1 } : null));
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
  return { notice: notice?.text ?? null, id: notice?.id, say, dismiss, action };
}
