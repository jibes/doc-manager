/* Image Capture extensions that lib.dom does not declare. */
interface ExtendedCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  zoom?: { min: number; max: number; step?: number };
  focusMode?: string[];
}

interface ImageCaptureLike {
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>;
  getPhotoCapabilities?(): Promise<{ imageWidth?: { max: number }; imageHeight?: { max: number } }>;
}

declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface OpenCamera {
  stream: MediaStream;
  track: MediaStreamTrack;
  label: string;
  torch: boolean;
}

/* ------------------------------------------------------------ selection ---- */

const FRONT = /front|user|face|selfie/i;
const BACK = /back|rear|environment|world/i;
const NOT_STANDARD =
  /ultra[\s-]?wide|ultrawide|super[\s-]?wide|0[.,]5\s*x|tele(photo)?|periscope|\b[2-9](?:\.\d+)?\s*x\b|macro|depth|infrared|\bir\b|truedepth|lidar|\btof\b|monochrome|desk\s*view/i;
const VIRTUAL = /dual|triple|virtual|logical/i;

/**
 * Score a camera label by how likely it is to be the standard 1x rear lens.
 * Phones list every lens as a device and `facingMode` may pick any of them,
 * often the ultra-wide, which is soft and distorted at document distance.
 */
export function scoreCamera(label: string, index: number): number {
  const text = label.toLowerCase();
  if (!text.trim()) return -index;
  let score = 0;
  if (FRONT.test(text)) score -= 100;
  if (BACK.test(text)) score += 20;
  if (NOT_STANDARD.test(text)) score -= 70;
  if (VIRTUAL.test(text)) score -= 10;
  if (/\b(back|rear) camera\b/.test(text) && !VIRTUAL.test(text)) score += 40; // iOS "Back Camera"
  if (/\bmain\b/.test(text)) score += 30;
  const android = /camera2?\s+(\d+)/.exec(text);
  if (android) score += 15 - Number(android[1]);
  return score;
}

export function pickCamera(devices: CameraDevice[]): CameraDevice | null {
  let best: CameraDevice | null = null;
  let bestScore = 0;
  devices.forEach((device, index) => {
    const score = scoreCamera(device.label, index);
    if (score > bestScore) {
      best = device;
      bestScore = score;
    }
  });
  return best;
}

export async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

/* --------------------------------------------------------------- stream ---- */

function request(deviceId: string | null): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    // A first guess at a phone sensor's full picture (4:3); `fullPicture` then
    // asks for the camera's own largest size. A 16:9 request would cut the top
    // and bottom off a 4:3 sensor.
    width: { ideal: 4096 },
    height: { ideal: 3072 },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: 'environment' };
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Open the rear camera, preferring the standard lens, or `deviceId` if given. */
export async function openCamera(deviceId: string | null): Promise<OpenCamera> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera access needs HTTPS (or localhost) and a browser with getUserMedia.');
  }

  let preferred = deviceId;
  // Once camera permission has been granted, labels are visible before any
  // stream is open: pick the standard lens straight away and open the camera
  // once, instead of opening one and then switching.
  if (!preferred) {
    const best = pickCamera(await listCameras());
    if (best) {
      try {
        return finishOpen(await request(best.deviceId));
      } catch {
        // Fall through to the slow path.
      }
    }
  }
  let stream: MediaStream;
  try {
    stream = await request(preferred);
  } catch (error) {
    if (!preferred) throw error;
    // Device ids rotate between sessions; fall back to automatic selection.
    preferred = null;
    stream = await request(null);
  }

  if (!preferred) {
    // Labels only become visible after permission, so pick now and reopen.
    const best = pickCamera(await listCameras());
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (best && best.deviceId !== current) {
      // Many phones cannot open two cameras at once.
      stopStream(stream);
      try {
        stream = await request(best.deviceId);
      } catch {
        stream = await request(current ?? null);
      }
    }
  }

  return finishOpen(stream);
}

/**
 * The camera's whole picture: its largest size, uncropped and unscaled. The
 * preview then shows everything the sensor sees (black bars where its shape
 * differs from the screen's), and the video frame, the still on browsers
 * without ImageCapture, has every pixel the camera streams.
 */
export function fullPicture(caps: MediaTrackCapabilities): MediaTrackConstraints {
  const width = caps.width?.max;
  const height = caps.height?.max;
  const native = (caps as { resizeMode?: string[] }).resizeMode?.includes('none');
  return {
    ...(width && height ? { width: { ideal: width }, height: { ideal: height } } : {}),
    ...(native ? { resizeMode: { ideal: 'none' } } : {}),
  } as MediaTrackConstraints;
}

/** Check the stream; ask for the camera's whole picture, the standard zoom and continuous focus. */
async function finishOpen(stream: MediaStream): Promise<OpenCamera> {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new Error('The camera produced no video.');
  }

  const caps = (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  const advanced: Record<string, unknown>[] = [];
  // A logical multi-camera can start at 0.5x; documents want the 1x lens.
  if (caps.zoom && caps.zoom.min < 1 && caps.zoom.max >= 1) advanced.push({ zoom: 1 });
  if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  // One call with everything: applying constraints replaces all earlier ones,
  // so zoom and focus alone would drop the size asked for when opening.
  const full = fullPicture(caps);
  if (advanced.length || Object.keys(full).length) {
    await track.applyConstraints({ ...full, ...(advanced.length ? { advanced } : {}) } as MediaTrackConstraints).catch(() => undefined);
  }

  return { stream, track, label: track.label || 'Camera', torch: caps.torch === true };
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<void> {
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
}

/* -------------------------------------------------------------- capture ---- */

async function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width) throw new Error('The camera has not produced a frame yet.');
  ctx.drawImage(video, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the frame'))),
      'image/jpeg',
      0.95,
    ),
  );
}

/**
 * Take the sharpest still available. Where ImageCapture exists (Chrome on
 * Android) that is a full-sensor photo, typically 3-4x the pixels of the video
 * stream; elsewhere it is the current video frame.
 */
export async function captureStill(
  track: MediaStreamTrack,
  video: HTMLVideoElement,
): Promise<Blob> {
  if (typeof ImageCapture !== 'undefined') {
    const capture = new ImageCapture(track);
    const take = (settings?: Record<string, unknown>) =>
      Promise.race([
        capture.takePhoto(settings),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
    // Ask for the sensor's full size: left to itself the browser may pick a
    // smaller default. Some cameras reject explicit sizes; then its default.
    const sizes = await capture.getPhotoCapabilities?.().catch(() => undefined);
    const largest =
      sizes?.imageWidth?.max && sizes.imageHeight?.max
        ? { imageWidth: sizes.imageWidth.max, imageHeight: sizes.imageHeight.max }
        : undefined;
    for (const settings of largest ? [largest, undefined] : [undefined]) {
      try {
        const photo = await take(settings);
        if (photo.size > 0) return photo;
      } catch {
        // Try the next way, then the video frame.
      }
    }
  }
  return grabFrame(video);
}
