import { useEffect, useRef, type ReactNode } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * A button that does something while it is held (the scanner's "Original"). A press-and-hold is also the
 * browser's gesture for selecting text and opening a context menu, and either cancels an ordinary press: here the
 * button keeps the pointer for itself until it is lifted, and the browser's gestures are turned off on it.
 */
export function HoldButton({ label, onHold, style, children, testID }: { label: string; onHold: (held: boolean) => void; style?: StyleProp<ViewStyle>; children: ReactNode; testID?: string }) {
  const ref = useRef<View>(null);
  const hold = useRef(onHold);
  useEffect(() => {
    hold.current = onHold;
  }, [onHold]);

  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el) return;
    let pointer: number | null = null;
    const down = (e: PointerEvent) => {
      if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      hold.current(true);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      hold.current(false);
    };
    const block = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', block);
    el.addEventListener('selectstart', block);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      el.removeEventListener('contextmenu', block);
      el.removeEventListener('selectstart', block);
    };
  }, []);

  return (
    <View
      ref={ref}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      // No panning, zooming or selecting starts on it: the finger belongs to the button.
      style={[style, Platform.OS === 'web' && ({ touchAction: 'none', userSelect: 'none', WebkitTouchCallout: 'none', cursor: 'pointer' } as object)]}
    >
      {children}
    </View>
  );
}
