import { useEffect, useRef, type ReactNode } from 'react';

export type ZoomViewProps = {
  children: ReactNode;
  /** Zoomed in far enough to want a sharper render. */
  onZoomed?: (zoomed: boolean) => void;
};

const MAX = 6;
/** Double tap or double click zooms to this, at the point tapped. */
const STEP = 2.5;
const DOUBLE_MS = 300;

/**
 * Pinch, double tap (or click) and wheel zoom, and dragging around once zoomed. The transform is set on the
 * element, not through React, so a gesture never re-renders what it moves.
 */
export function ZoomView({ children, onZoomed }: ZoomViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const report = useRef(onZoomed);
  useEffect(() => {
    report.current = onZoomed;
  });

  useEffect(() => {
    const el = box.current;
    const content = inner.current;
    if (!el || !content) return;
    let s = 1;
    let tx = 0;
    let ty = 0;
    let zoomed = false;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; s: number; cx: number; cy: number } | null = null;
    let lastTap = { at: 0, x: 0, y: 0 };
    let moved = 0;

    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const apply = (animate = false) => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      s = Math.min(MAX, Math.max(1, s));
      // The page always covers what it covered unzoomed: no dragging it off the screen.
      tx = Math.min(0, Math.max(w - w * s, tx));
      ty = Math.min(0, Math.max(h - h * s, ty));
      content.style.transition = animate ? 'transform 180ms ease-out' : 'none';
      content.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      el.style.cursor = s > 1 ? 'grab' : 'zoom-in';
      if (s > 1.2 !== zoomed) {
        zoomed = s > 1.2;
        report.current?.(zoomed);
      }
    };
    /** Zoom to `to`, keeping the page's point under (x, y) where it is. */
    const zoomAt = (to: number, x: number, y: number, animate = false) => {
      const cx = (x - tx) / s;
      const cy = (y - ty) / s;
      s = Math.min(MAX, Math.max(1, to));
      tx = x - cx * s;
      ty = y - cy * s;
      apply(animate);
    };
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) moved = 0;
      if (pointers.size === 2) {
        const p = spread();
        pinch = { dist: p.dist || 1, s, cx: (p.x - tx) / s, cy: (p.y - ty) / s };
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const at = local(e);
      pointers.set(e.pointerId, at);
      moved += Math.hypot(at.x - prev.x, at.y - prev.y);
      if (pinch && pointers.size >= 2) {
        const p = spread();
        s = Math.min(MAX, Math.max(1, (pinch.s * p.dist) / pinch.dist));
        tx = p.x - pinch.cx * s;
        ty = p.y - pinch.cy * s;
        apply();
      } else if (pointers.size === 1 && s > 1) {
        tx += at.x - prev.x;
        ty += at.y - prev.y;
        apply();
      }
    };
    const up = (e: PointerEvent) => {
      const at = pointers.get(e.pointerId);
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!at || pointers.size || moved > 10) return;
      const now = performance.now();
      if (now - lastTap.at < DOUBLE_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 30) {
        if (s > 1) {
          s = 1;
          tx = ty = 0;
          apply(true);
        } else zoomAt(STEP, at.x, at.y, true);
        lastTap = { at: 0, x: 0, y: 0 };
      } else lastTap = { at: now, x: at.x, y: at.y };
    };
    const cancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = local(e);
      // Trackpad pinches arrive as wheel events with ctrl held, in smaller steps.
      zoomAt(s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), at.x, at.y);
    };
    const resize = new ResizeObserver(() => apply());
    resize.observe(el);

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('wheel', wheel, { passive: false });
    apply();
    return () => {
      if (zoomed) report.current?.(false);
      resize.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <div ref={box} data-testid="scan-zoom" style={{ position: 'relative', flex: 1, overflow: 'hidden', touchAction: 'none', userSelect: 'none' }}>
      <div ref={inner} style={{ position: 'absolute', inset: 0, transformOrigin: '0 0' }}>
        {children}
      </div>
    </div>
  );
}
