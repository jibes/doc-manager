import { useEffect, useRef, useState, type PointerEvent } from 'react';

import { t } from '@/core/i18n';
import { DragFilter } from '../dragFilter';
import type { Point, Quad } from '../engine/imaging/image';
import { isConvex } from '../engine/imaging/quad';
import type { Page } from '../types';

export type CropEditorProps = { page: Page; quad: Quad; onChange: (quad: Quad) => void };

const DISPLAY_EDGE = 2048;
const LOUPE = 128;
const ZOOM = 3;
/** How close (px) a touch must land to a corner or edge handle to take it. */
const HIT = 40;
const MARGIN = 22;

type Grab = { kind: 'corner' | 'edge'; index: number; pointer: Point; quad: Quad };

/**
 * The photo with the page's corners: drag a corner, or an edge along its normal. The finger is filtered
 * (relative, finer after a rest, steady on lift) and a loupe shows the spot under it.
 */
export function CropEditor({ page, quad, onChange }: CropEditorProps) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const loupe = useRef<HTMLCanvasElement>(null);
  const filter = useRef(new DragFilter());
  const grab = useRef<Grab | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [focus, setFocus] = useState<Point | null>(null);
  const [fine, setFine] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let shown: ImageBitmap | null = null;
    void (async () => {
      const probe = await createImageBitmap(page.source, { imageOrientation: 'from-image' });
      const scale = Math.min(1, DISPLAY_EDGE / Math.max(probe.width, probe.height));
      let display = probe;
      if (scale < 1) {
        display = await createImageBitmap(page.source, {
          imageOrientation: 'from-image',
          resizeWidth: Math.round(probe.width * scale),
          resizeHeight: Math.round(probe.height * scale),
          resizeQuality: 'high',
        });
        probe.close();
      }
      if (cancelled) display.close();
      else setBitmap((shown = display));
    })();
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (stage.current) observer.observe(stage.current);
    return () => {
      cancelled = true;
      observer.disconnect();
      shown?.close();
    };
  }, [page.source]);

  // Where the photo sits in the stage (contain, with room for the handles).
  const cw = size.width - MARGIN * 2;
  const ch = size.height - MARGIN * 2;
  const scale = cw > 0 && ch > 0 ? Math.min(cw / page.width, ch / page.height) : 0;
  const layout = scale ? { scale, x: MARGIN + (cw - page.width * scale) / 2, y: MARGIN + (ch - page.height * scale) / 2, w: page.width * scale, h: page.height * scale } : null;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bitmap || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.width * dpr);
    c.height = Math.round(size.height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, layout.x, layout.y, layout.w, layout.h);
  }, [bitmap, layout?.x, layout?.y, layout?.w, layout?.h, size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const toScreen = (p: Point): Point => (layout ? [layout.x + p[0] * layout.scale, layout.y + p[1] * layout.scale] : [0, 0]);
  const screenQuad = quad.map(toScreen);
  const midpoints = screenQuad.map((p, i) => {
    const q = screenQuad[(i + 1) % 4];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Point;
  });
  const valid = isConvex(quad);

  const clamp = (p: Point): Point => [Math.min(page.width, Math.max(0, p[0])), Math.min(page.height, Math.max(0, p[1]))];
  const local = (e: { clientX: number; clientY: number }): Point => {
    const rect = stage.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /** Move the grabbed handle by the filtered pointer's travel since touch-down. */
  const place = (pointer: Point) => {
    const g = grab.current;
    if (!g || !layout) return;
    const dx = (pointer[0] - g.pointer[0]) / layout.scale;
    const dy = (pointer[1] - g.pointer[1]) / layout.scale;
    const next = [...g.quad] as Point[];
    const i = g.index;
    if (g.kind === 'corner') {
      next[i] = clamp([g.quad[i][0] + dx, g.quad[i][1] + dy]);
      setFocus(next[i]);
    } else {
      // An edge moves along its normal, keeping its direction.
      const j = (i + 1) % 4;
      const [a, b] = [g.quad[i], g.quad[j]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const d = dx * nx + dy * ny;
      next[i] = clamp([a[0] + nx * d, a[1] + ny * d]);
      next[j] = clamp([b[0] + nx * d, b[1] + ny * d]);
      setFocus([(next[i][0] + next[j][0]) / 2, (next[i][1] + next[j][1]) / 2]);
    }
    onChange(next as unknown as Quad);
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    const p = local(event);
    let best: { kind: 'corner' | 'edge'; index: number; d: number } | null = null;
    screenQuad.forEach((c, i) => {
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d < HIT && (!best || d < best.d)) best = { kind: 'corner', index: i, d };
    });
    if (!best)
      midpoints.forEach((m, i) => {
        const d = Math.hypot(m[0] - p[0], m[1] - p[1]);
        if (d < HIT && (!best || d < best.d)) best = { kind: 'edge', index: i, d };
      });
    if (!best) return;
    const hit: { kind: 'corner' | 'edge'; index: number } = best;
    event.preventDefault();
    stage.current!.setPointerCapture(event.pointerId);
    // The handle moves with the finger from where it is: it never jumps to it.
    grab.current = { ...hit, pointer: filter.current.start(p, event.timeStamp), quad };
    setFine(false);
    setFocus(hit.kind === 'corner' ? quad[hit.index] : layout ? [(midpoints[hit.index][0] - layout.x) / layout.scale, (midpoints[hit.index][1] - layout.y) / layout.scale] : null);
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!grab.current) return;
    // Every sample the browser merged into this event, for an exact path.
    const merged = event.nativeEvent.getCoalescedEvents?.() ?? [];
    let pointer: Point | null = null;
    for (const e of merged.length ? merged : [event.nativeEvent]) pointer = filter.current.move(local(e), e.timeStamp);
    if (pointer) place(pointer);
    setFine(filter.current.fine);
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    // Lifting the finger nudges the point; the filter takes that back.
    if (grab.current && event.type === 'pointerup') place(filter.current.end(local(event), event.timeStamp));
    grab.current = null;
    setFocus(null);
    setFine(false);
  };

  useEffect(() => {
    const c = loupe.current;
    if (!c || !focus || !bitmap || !layout) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = LOUPE * dpr;
    c.height = LOUPE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toBitmap = bitmap.width / page.width;
    const span = LOUPE / ZOOM / layout.scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, (focus[0] - span / 2) * toBitmap, (focus[1] - span / 2) * toBitmap, span * toBitmap, span * toBitmap, 0, 0, LOUPE, LOUPE);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, LOUPE / 2 - 14);
    ctx.lineTo(LOUPE / 2, LOUPE / 2 + 14);
    ctx.moveTo(LOUPE / 2 - 14, LOUPE / 2);
    ctx.lineTo(LOUPE / 2 + 14, LOUPE / 2);
    ctx.stroke();
  }, [focus, bitmap, page.width, layout?.scale]); // eslint-disable-line react-hooks/exhaustive-deps

  // The loupe sits in the top corner away from the finger.
  const loupeLeft = focus && layout ? toScreen(focus)[0] > size.width / 2 : false;
  const points = screenQuad.map((p) => p.join(',')).join(' ');

  return (
    <div
      ref={stage}
      role="application"
      aria-label={t.scanCropHint}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      style={{ position: 'relative', flex: 1, overflow: 'hidden', touchAction: 'none', background: '#000', userSelect: 'none' }}
    >
      <canvas ref={canvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      {layout && (
        <svg aria-hidden viewBox={`0 0 ${size.width} ${size.height}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <defs>
            <mask id="crop-outside">
              <rect width="100%" height="100%" fill="white" />
              <polygon points={points} fill="black" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.5)" mask="url(#crop-outside)" />
          <polygon points={points} fill="none" stroke={valid ? '#fff' : '#FF6B5B'} strokeWidth={2} strokeLinejoin="round" />
          {midpoints.map((m, i) => {
            const a = screenQuad[i];
            const b = screenQuad[(i + 1) % 4];
            const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
            return <rect key={i} x={m[0] - 14} y={m[1] - 4} width={28} height={8} rx={4} fill="#fff" transform={`rotate(${angle} ${m[0]} ${m[1]})`} />;
          })}
          {screenQuad.map((c, i) => (
            <circle key={i} cx={c[0]} cy={c[1]} r={11} fill="rgba(255,255,255,0.25)" stroke="#fff" strokeWidth={2.5} />
          ))}
        </svg>
      )}
      {focus && (
        <canvas
          ref={loupe}
          style={{
            position: 'absolute',
            top: 12,
            ...(loupeLeft ? { left: 12 } : { right: 12 }),
            width: LOUPE,
            height: LOUPE,
            borderRadius: LOUPE / 2,
            border: `2px solid ${fine ? '#5B8CFF' : '#fff'}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        />
      )}
    </div>
  );
}
