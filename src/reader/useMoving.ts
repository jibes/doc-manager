import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Phones: the page number and bookmark step aside while the pages move, and come back when they stop.
 * `moved` is called with every scroll; `moving` is true until it has been still for a moment.
 */
export function useMoving(enabled: boolean) {
  const [moving, setMoving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const moved = useCallback(() => {
    if (!enabled) return;
    setMoving(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoving(false), 1200);
  }, [enabled]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { moving: enabled && moving, moved };
}
