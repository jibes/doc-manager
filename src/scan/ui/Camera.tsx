import type { FilterId } from '../engine/imaging/filters';

export type CameraProps = {
  deviceId: string | null;
  autoCapture: boolean;
  defaultFilter: FilterId;
  retakeId: string | null;
  onAutoCapture: (on: boolean) => void;
  onClose: () => void;
  onCrop: (pageId: string) => void;
  onRetaken: (pageId: string) => void;
  say: (message: string) => void;
};

/** Scanning is web only (and the Android app, which runs the web app). */
export function Camera(_: CameraProps) {
  return null;
}
