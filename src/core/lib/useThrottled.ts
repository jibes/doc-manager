import { useEffect, useRef, useState } from 'react';

/** `value`, changing at most every `ms` (the latest change always arrives). */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const timer = setTimeout(
      () => {
        last.current = Date.now();
        setShown(value);
      },
      Math.max(0, last.current + ms - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}
