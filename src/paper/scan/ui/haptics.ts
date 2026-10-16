/** Short vibration patterns, where the device supports them. */
const PATTERNS = {
  /** A photo was taken. */
  capture: 30,
  /** Something was picked up or a mode changed. */
  tick: 10,
  /** A completed action: saved, uploaded. */
  success: [15, 60, 25],
  /** Something went wrong. */
  error: [40, 50, 40],
} as const;

export function haptic(kind: keyof typeof PATTERNS): void {
  try {
    navigator.vibrate?.(PATTERNS[kind] as number | number[]);
  } catch {
    // Not supported (iOS Safari); haptics are a nicety.
  }
}
