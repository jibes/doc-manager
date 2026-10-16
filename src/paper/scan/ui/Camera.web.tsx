import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/paper/components/Icon';
import { T } from '@/paper/components/primitives';
import { radius, space } from '@/core/design/tokens';
import { scanError, t } from '@/core/i18n';
import { captureStill, openCamera, setTorch, stopStream } from '../engine/camera/camera';
import type { Detection } from '../engine/detect/heatmap';
import { MODEL_INPUT } from '../engine/detect/model';
import type { FilterId } from '../engine/imaging/filters';
import type { Point, Quad } from '../engine/imaging/image';
import { addPhoto, importPhotos } from '../importPhotos';
import { detector } from '../services';
import { useScan } from '../session';
import { PageImage } from './PageImage';
import { haptic } from './haptics';

export type CameraProps = {
  deviceId: string | null;
  autoCapture: boolean;
  defaultFilter: FilterId;
  /** The capture replaces this page's photo instead of adding a page. */
  retakeId: string | null;
  /** The screen is in front: the camera runs only then (not under the crop screen). */
  active: boolean;
  onAutoCapture: (on: boolean) => void;
  onClose: () => void;
  /** No page edges were found on a photo taken by hand: crop it. */
  onCrop: (pageId: string) => void;
  onRetaken: (pageId: string) => void;
  say: (message: string) => void;
};

/** Hold still this long before auto-capture fires. */
const STEADY_MS = 1100;
/** Max per-frame corner movement (fraction of the frame) that still counts as steady. */
const STEADY_MOVE = 0.012;
/** After an auto-capture, the page must move this much (or leave) before the next one. */
const REARM_MOVE = 0.08;
const MIN_CONFIDENCE = 0.45;
/** A page covering less of the frame than this is too far away to read well. */
const SMALL_AREA = 0.18;
/** Mean frame brightness (0..1) below which the scene is too dark. */
const DARK_LUMA = 0.16;

/** A transparent pixel: no default poster while the stream starts. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const BLUE = '#5B8CFF';
const GREEN = '#3DDC84';

function maxMove(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

const blend = (prev: Quad, next: Quad, k: number): Quad =>
  prev.map((p, i) => [p[0] + (next[i][0] - p[0]) * k, p[1] + (next[i][1] - p[1]) * k] as Point) as unknown as Quad;

/** Area of a quad in normalised frame coordinates. */
function area(q: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  return Math.abs(sum) / 2;
}

function cameraMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t.scanCameraBlocked;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t.scanCameraMissing;
  if (name === 'NotReadableError' || name === 'AbortError') return t.scanCameraBusy;
  return scanError(error);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The camera: finds the page in the live picture, takes it by itself once the phone is held steady (or on
 * the shutter), and adds it to the document. Photos can be imported instead.
 */
export function Camera({ deviceId, autoCapture, defaultFilter, retakeId, active, onAutoCapture, onClose, onCrop, onRetaken, say }: CameraProps) {
  const insets = useSafeAreaInsets();
  const pages = useScan((s) => s.pages);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [torch, setTorchState] = useState<{ available: boolean; on: boolean }>({ available: false, on: false });
  const [detectorState, setDetectorState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [quad, setQuad] = useState<Quad | null>(null);
  const [shown, setShown] = useState<Quad | null>(null);
  const [steady, setSteady] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [exposing, setExposing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const [dark, setDark] = useState(false);
  const [restart, setRestart] = useState(0);

  // What the loops read: kept in refs so they see the latest without restarting.
  const live = useRef({
    track: null as MediaStreamTrack | null,
    ready: false,
    capturing: false,
    hidden: false,
    detector: detector(),
    detectorReady: false,
    raw: null as Quad | null,
    quad: null as Quad | null,
    misses: 0,
    steadySince: 0,
    armed: true,
    lastCaptured: null as Quad | null,
    autoCapture,
    dark: false,
  });
  const capture = useRef<(auto: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    live.current.autoCapture = autoCapture;
  }, [autoCapture]);

  // The page detector: replaced when the camera opens or the app returns, never in a loop while it fails.
  const connectDetector = useRef(() => {
    const client = detector();
    live.current.detector = client;
    live.current.detectorReady = false;
    setDetectorState('loading');
    client.ready.then(
      () => {
        if (live.current.detector !== client) return;
        live.current.detectorReady = true;
        setDetectorState('ready');
      },
      () => live.current.detector === client && setDetectorState('failed'),
    );
  });

  const resetTracking = () => {
    const l = live.current;
    l.raw = null;
    l.quad = null;
    l.misses = 0;
    setQuad(null);
    setSteady(0);
  };

  // Camera: open, follow the track, close in the background (leave it to other apps) and under another screen.
  useEffect(() => {
    if (!active) return;
    let token = 0;
    let stream: MediaStream | null = null;
    let lastRestart = 0;
    const l = live.current;

    const close = () => {
      token++;
      stopStream(stream);
      stream = null;
      l.track = null;
      l.ready = false;
      setCameraReady(false);
      resetTracking();
    };

    const start = async () => {
      close();
      const mine = token;
      setCameraError('');
      try {
        const camera = await openCamera(deviceId);
        if (mine !== token) return stopStream(camera.stream);
        stream = camera.stream;
        l.track = camera.track;
        setTorchState({ available: camera.torch, on: false });
        // The browser ends the track when another app takes the camera; a muted one stops delivering frames.
        camera.track.addEventListener('ended', () => {
          if (camera.track !== l.track || l.hidden) return;
          if (performance.now() - lastRestart < 3000) {
            close();
            setCameraError(t.scanCameraStopped);
            return;
          }
          lastRestart = performance.now();
          void start();
        });
        camera.track.addEventListener('mute', () => camera.track === l.track && resetTracking());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => undefined);
        }
        if (mine === token) {
          l.ready = true;
          setCameraReady(true);
        }
      } catch (error) {
        if (mine === token) setCameraError(cameraMessage(error));
      }
    };

    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        l.hidden = true;
        close();
      } else if (l.hidden) {
        l.hidden = false;
        void start();
        if (l.detector.dead) connectDetector.current();
      }
    };

    // For the record (Android smoke test): text recognition runs multi-threaded only when isolated.
    console.info(`Scanner: cross-origin isolated ${self.crossOriginIsolated}`);
    l.hidden = document.visibilityState === 'hidden';
    if (!l.hidden) void start();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      close();
    };
  }, [deviceId, restart, active]);

  // Detection loop and the outline's easing.
  useEffect(() => {
    let running = true;
    const l = live.current;
    connectDetector.current();

    const onDetection = (detection: Detection | null) => {
      const now = performance.now();
      if (!detection || detection.confidence < MIN_CONFIDENCE) {
        if (++l.misses > 3) {
          l.raw = null;
          l.quad = null;
          // The page left the frame: the next one may be taken by itself.
          l.armed = true;
          setQuad(null);
          setSteady(0);
        }
        return;
      }
      l.misses = 0;
      const next = detection.quad;
      if (!l.raw || maxMove(l.raw, next) > STEADY_MOVE) l.steadySince = now;
      l.raw = next;
      l.quad = next;
      setQuad(next);
      if (!l.armed && l.lastCaptured && maxMove(l.lastCaptured, next) > REARM_MOVE) l.armed = true;
      const held = l.armed ? Math.min(1, (now - l.steadySince) / STEADY_MS) : 0;
      setSteady(held);
      if (l.autoCapture && l.armed && held >= 1 && !l.capturing) void capture.current(true);
    };

    void (async () => {
      const canvas = document.createElement('canvas');
      canvas.width = MODEL_INPUT;
      canvas.height = MODEL_INPUT;
      const ctx = canvas.getContext('2d');
      const probe = Object.assign(document.createElement('canvas'), { width: 16, height: 16 }).getContext('2d', { willReadFrequently: true });
      let frames = 0;
      while (running) {
        const v = video.current;
        if (!l.detectorReady || !l.ready || l.hidden || l.track?.muted || l.capturing || !v || v.readyState < 2) {
          await sleep(120);
          continue;
        }
        const started = performance.now();
        try {
          if (probe && frames++ % 8 === 0) {
            probe.drawImage(v, 0, 0, 16, 16);
            const { data } = probe.getImageData(0, 0, 16, 16);
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            const mean = sum / (data.length / 4) / 255;
            // Hysteresis, so the hint does not flicker around the limit.
            l.dark = l.dark ? mean < DARK_LUMA * 1.25 : mean < DARK_LUMA;
            setDark(l.dark);
          }
          ctx?.drawImage(v, 0, 0, MODEL_INPUT, MODEL_INPUT);
          const { detection } = await l.detector.frame(await createImageBitmap(canvas));
          // The camera may have closed or paused while the frame was in flight.
          if (running && !l.capturing && l.ready && !l.track?.muted) onDetection(detection);
        } catch {
          if (l.detector.dead) {
            setDetectorState('failed');
            l.detectorReady = false;
            l.raw = l.quad = null;
            setQuad(null);
            setSteady(0);
          }
          await sleep(300);
        }
        // Leave the main thread some air on slow phones.
        await sleep(Math.max(16, 70 - (performance.now() - started)));
      }
    })();

    let last = 0;
    let frame = requestAnimationFrame(function animate(time) {
      const dt = Math.min(100, time - (last || time));
      last = time;
      const target = l.quad;
      // Exponential ease: ~90% of the way in 120 ms, whatever the frame rate.
      setShown((prev) => (!target ? null : !prev ? target : maxMove(prev, target) > 0.0005 ? blend(prev, target, 1 - Math.exp(-dt / 52)) : prev));
      frame = requestAnimationFrame(animate);
    });

    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (stage.current) observer.observe(stage.current);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Taking the photo. Kept in a ref so the detection loop calls the current one.
  useEffect(() => {
    let addedTimer: ReturnType<typeof setTimeout> | undefined;
    let mounted = true;
    capture.current = async (auto: boolean) => {
      const l = live.current;
      if (l.capturing || !l.track || !video.current) return;
      l.capturing = true;
      setCapturing(true);
      setExposing(true);
      l.lastCaptured = l.raw;
      l.armed = false;
      setSteady(0);
      // The page as the preview shows it now: the photo is cropped to it if the stricter search on the photo fails.
      const v = video.current;
      const hint = l.quad && v.videoWidth && v.videoHeight ? { quad: l.quad, aspect: v.videoWidth / v.videoHeight } : undefined;
      try {
        const still = await captureStill(l.track, v);
        // The flash and buzz mean "done, you can move": only once the photo is actually taken.
        setExposing(false);
        setFlash(true);
        setTimeout(() => setFlash(false), 180);
        haptic('capture');
        const { id, found, blurred, offFrame } = await addPhoto(l.detector, still, { filter: defaultFilter, retakeId, hint });
        if (l.detector.dead) setDetectorState('failed');
        if (!mounted) return;
        if (!retakeId) {
          setAdded(useScan.getState().pages.length);
          clearTimeout(addedTimer);
          addedTimer = setTimeout(() => setAdded(null), 1400);
        }
        if (blurred) say(t.scanBlurred);
        else if (offFrame) say(t.scanOffFrame);
        if (retakeId) onRetaken(id);
        // The crop screen says why it opened (no edges found): a message here would wait until it is closed.
        else if (!found && !auto) onCrop(id);
      } catch (error) {
        if (mounted && !l.hidden) say(t.scanCaptureFailed(scanError(error)));
      } finally {
        l.capturing = false;
        setExposing(false);
        setCapturing(false);
      }
    };
    return () => {
      mounted = false;
      clearTimeout(addedTimer);
    };
  }, [defaultFilter, retakeId, onCrop, onRetaken, say]);

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (!files.length) return;
    const l = live.current;
    l.capturing = true;
    setCapturing(true);
    const before = useScan.getState().pages.length;
    const summary = await importPhotos(l.detector, files, { filter: defaultFilter, retakeId });
    l.capturing = false;
    setCapturing(false);
    if (summary.failed) say(t.scanImportFailed(summary.failed));
    else if (summary.missing) say(t.scanImportNoEdges(summary.missing));
    else if (summary.cut) say(t.scanImportCut(summary.cut));
    if (retakeId) onRetaken(retakeId);
    // Nothing came of it: the camera stays, with what went wrong.
    else if (useScan.getState().pages.length > before) onClose();
  };

  const toggleTorch = async () => {
    const track = live.current.track;
    if (!track) return;
    try {
      await setTorch(track, !torch.on);
      setTorchState((s) => ({ ...s, on: !s.on }));
    } catch {
      say(t.scanFlashFailed);
    }
  };

  // The whole camera picture, as large as fits, at the bottom of the stage (a black bar above it, not a crop):
  // every pixel the camera sees is shown, so what is framed is what is taken.
  const { width: vw, height: vh } = videoSize;
  const { width: cw, height: ch } = stageSize;
  const scale = vw && vh && cw && ch ? Math.min(cw / vw, ch / vh) : 0;
  const frame = scale ? { left: (cw - vw * scale) / 2, top: ch - vh * scale, width: vw * scale, height: vh * scale } : null;
  // Normalised frame points → stage pixels.
  const polygon = shown && frame ? shown.map(([x, y]) => `${frame.left + x * frame.width},${frame.top + y * frame.height}`).join(' ') : '';

  const status =
    detectorState === 'loading'
      ? t.scanDetectorLoading
      : detectorState === 'failed'
        ? t.scanDetectorFailed
        : capturing
          ? exposing
            ? t.scanHoldStill
            : t.scanProcessing
          : added !== null
            ? t.scanPageAdded(added)
            : dark && cameraReady
              ? torch.available && !torch.on
                ? t.scanTooDarkFlash
                : t.scanTooDark
              : quad && area(quad) < SMALL_AREA
                ? t.scanMoveCloser
                : quad && autoCapture && steady > 0
                  ? t.scanHoldSteady
                  : !quad && cameraReady
                    ? t.scanPointAtPage
                    : '';
  const last = pages.at(-1);

  return (
    <View style={styles.screen}>
      <div ref={stage} style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <div
          data-testid="camera-frame"
          style={{ position: 'absolute', overflow: 'hidden', borderRadius: 24, ...(frame ?? { left: 0, top: 0, width: '100%', height: '100%' }) }}
        >
          <video
            ref={video}
            // The picture is decoration for screen readers (the status line says what matters), and Android's
            // WebView would otherwise announce "Unable to play media" and draw its grey play-button poster.
            aria-hidden
            poster={BLANK}
            disablePictureInPicture
            playsInline
            muted
            autoPlay
            onLoadedMetadata={(e) => setVideoSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
            onResize={(e) => setVideoSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
            // The frame has the picture's shape; until both sizes are known, the whole picture is shown all the same.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
          {flash && <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0.85 }} />}
        </div>
        <svg aria-hidden viewBox={`0 0 ${cw || 1} ${ch || 1}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {polygon && (
            <polygon
              points={polygon}
              fill={steady > 0.05 ? 'rgba(61,220,132,0.16)' : 'rgba(91,140,255,0.14)'}
              stroke={steady > 0.05 ? GREEN : BLUE}
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
          )}
        </svg>
        {cameraError ? (
          <View style={styles.notice}>
            <T v="body" color="#fff" style={{ textAlign: 'center' }}>
              {cameraError}
            </T>
            <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', justifyContent: 'center' }}>
              <Chip label={t.scanTryAgain} primary onPress={() => setRestart((n) => n + 1)} />
              <Chip label={t.scanChoosePhotos} onPress={() => input.current?.click()} />
            </View>
          </View>
        ) : null}
        <View pointerEvents="none" style={[styles.status, { bottom: space.lg }]}>
          {status ? (
            <View accessibilityLiveRegion="polite" style={styles.pill}>
              <T v="label" color="#fff">
                {status}
              </T>
            </View>
          ) : null}
        </View>
        <View style={[styles.top, { top: insets.top + space.sm }]}>
          <Round icon="close" label={t.scanCloseCamera} onPress={onClose} />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {torch.available && <Round icon={torch.on ? 'flash' : 'flashOff'} label={t.scanFlash} active={torch.on} onPress={() => void toggleTorch()} />}
            {!retakeId && !cameraError && (
              <Pressable
                accessibilityRole="switch"
                aria-checked={autoCapture}
                onPress={() => onAutoCapture(!autoCapture)}
                style={[styles.auto, autoCapture && { backgroundColor: 'rgba(255,255,255,0.92)' }]}
              >
                <View style={[styles.dot, { backgroundColor: autoCapture ? GREEN : 'rgba(255,255,255,0.5)' }]} />
                <T v="label" color={autoCapture ? '#111' : '#fff'}>
                  {t.scanAuto}
                </T>
              </Pressable>
            )}
          </View>
        </View>
      </div>
      <View style={[styles.controls, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.side}>
          <Round testID="scan-import" icon="image" label={t.scanImport} onPress={() => input.current?.click()} />
        </View>
        {/* No camera (or none allowed): photos can still be imported; nothing to take or time. */}
        {cameraError ? <View style={styles.shutter} /> : (
        <Pressable
          testID="scan-shutter"
          accessibilityRole="button"
          accessibilityLabel={t.scanShutter}
          disabled={!cameraReady || capturing}
          onPress={() => void capture.current(false)}
          style={({ pressed }) => [styles.shutter, { opacity: !cameraReady || capturing ? 0.45 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
        >
          <svg width={76} height={76} viewBox="0 0 76 76" aria-hidden style={{ position: 'absolute' }}>
            <circle cx={38} cy={38} r={35} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={4} />
            {steady > 0 && (
              <circle
                cx={38}
                cy={38}
                r={35}
                fill="none"
                stroke={GREEN}
                strokeWidth={4}
                strokeLinecap="round"
                strokeDasharray={`${steady * 2 * Math.PI * 35} 999`}
                transform="rotate(-90 38 38)"
              />
            )}
          </svg>
          <View style={styles.shutterCore} />
        </Pressable>
        )}
        <View style={[styles.side, { alignItems: 'flex-end' }]}>
          {!retakeId && last && (
            <Pressable testID="scan-done" accessibilityRole="button" accessibilityLabel={t.scanDoneA11y(pages.length)} onPress={onClose} style={styles.done}>
              <View style={styles.thumb}>
                <PageImage page={last} longEdge={240} channel="camera-thumb" />
              </View>
              <View>
                <T v="label" color="#fff" style={{ fontWeight: '600' }}>
                  {t.scanDone}
                </T>
                <T v="caption" color="rgba(255,255,255,0.7)">
                  {t.scanPages(pages.length)}
                </T>
              </View>
            </Pressable>
          )}
        </View>
      </View>
      <input
        ref={input}
        data-testid="scan-file"
        type="file"
        accept="image/*"
        multiple={!retakeId}
        hidden
        onChange={(e) => void importFiles(e)}
      />
    </View>
  );
}

function Round({ icon, label, active, onPress, testID }: { icon: Parameters<typeof Icon>[0]['name']; label: string; active?: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.round, active && { backgroundColor: 'rgba(255,255,255,0.92)' }, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon name={icon} color={active ? '#111' : '#fff'} size={22} />
    </Pressable>
  );
}

function Chip({ label, primary, onPress }: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, primary && { backgroundColor: '#fff' }]}>
      <T v="label" color={primary ? '#111' : '#fff'}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  notice: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.xl },
  status: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: { backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm },
  top: { position: 'absolute', left: space.lg, right: space.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  auto: { flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 44, paddingHorizontal: space.lg, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  chip: { borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm + 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' },
  controls: { flexDirection: 'row', alignItems: 'center', paddingTop: space.lg, paddingHorizontal: space.lg },
  side: { flex: 1 },
  shutter: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  shutterCore: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  done: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  thumb: { width: 40, height: 52, borderRadius: 6, overflow: 'hidden', backgroundColor: '#222' },
});
