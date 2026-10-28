import type { ReactNode } from 'react';
import { View } from 'react-native';

export type ZoomViewProps = { children: ReactNode; onZoomed?: (zoomed: boolean) => void };

/** Scanning is web only (and the Android app, which runs the web app). */
export function ZoomView({ children }: ZoomViewProps) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
