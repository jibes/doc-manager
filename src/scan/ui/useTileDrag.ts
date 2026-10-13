import { useEffect, useRef, useState, type RefObject } from 'react';
import { Platform, type View } from 'react-native';

import { haptic } from './haptics';

/** How long a finger rests on a tile before it is picked up. */
const HOLD_MS = 350;
/** Movement before that is a scroll (touch) or starts the drag at once (mouse). */
const SLOP = 8;
const TILE = '[data-testid="scan-tile"]';

/** The tile being dragged: the order it would drop into, and how far to move it from its slot in that order. */
export type TileDrag = { id: string; order: string[]; dx: number; dy: number };

type Press = {
  pointerId: number;
  x: number;
  y: number;
  touch: boolean;
  from: number;
  timer: ReturnType<typeof setTimeout>;
  /** Set once picked up: where every slot was when the drag began. */
  slots?: DOMRect[];
  target?: number;
};

/**
 * Press and hold a page in the grid, then drag it to a new place (a mouse can drag straight away). The grid's
 * element gets the pointer events; its tiles are found by their testID, in the order of `ids`.
 */
export function useTileDrag(grid: RefObject<View | null>, ids: string[], onDrop: (id: string, index: number) => void, enabled: boolean): TileDrag | null {
  const [drag, setDrag] = useState<TileDrag | null>(null);
  const latest = useRef({ ids, onDrop });
  useEffect(() => {
    latest.current = { ids, onDrop };
  }, [ids, onDrop]);

  useEffect(() => {
    const el = grid.current as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || !el || !enabled) return;
    let press: Press | null = null;

    const tiles = () => [...el.querySelectorAll<HTMLElement>(TILE)];
    const end = () => {
      if (press) clearTimeout(press.timer);
      press = null;
      setDrag(null);
    };
    const begin = () => {
      if (!press || press.slots) return;
      press.slots = tiles().map((t) => t.getBoundingClientRect());
      press.target = press.from;
      haptic('tick');
      setDrag({ id: latest.current.ids[press.from], order: latest.current.ids, dx: 0, dy: 0 });
    };
    const follow = (x: number, y: number) => {
      const { slots, from } = press!;
      if (!slots) return;
      // The slot whose centre is nearest the pointer.
      let target = from;
      let best = Infinity;
      slots.forEach((r, i) => {
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < best) [best, target] = [d, i];
      });
      press!.target = target;
      const id = latest.current.ids[from];
      const order = latest.current.ids.filter((k) => k !== id);
      order.splice(target, 0, id);
      // Where the tile was, plus how far the pointer moved, less where its new slot is.
      setDrag({ id, order, dx: slots[from].left - slots[target].left + x - press!.x, dy: slots[from].top - slots[target].top + y - press!.y });
    };

    const down = (e: PointerEvent) => {
      if (press || !e.isPrimary || e.button !== 0) return;
      const tile = (e.target as Element).closest(TILE);
      const from = tile ? tiles().indexOf(tile as HTMLElement) : -1;
      if (from < 0) return;
      const touch = e.pointerType !== 'mouse';
      press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch, from, timer: setTimeout(begin, HOLD_MS) };
    };
    const move = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      if (!press.slots) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return;
        // A finger moving early is scrolling the page; a mouse moving with the button down is dragging.
        if (press.touch) return end();
        begin();
      }
      follow(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      const { slots, target, from } = press;
      if (slots && target != null) {
        // The release is not a tap on the tile.
        const swallow = (c: Event) => {
          c.preventDefault();
          c.stopPropagation();
        };
        addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
        if (target !== from) latest.current.onDrop(latest.current.ids[from], target);
      }
      end();
    };
    // While a tile is held, the page must not scroll, and a long press must not open the image menu.
    const touchMove = (e: TouchEvent) => press?.slots && e.cancelable && e.preventDefault();
    const menu = (e: Event) => press && e.preventDefault();
    const nativeDrag = (e: Event) => e.preventDefault();

    el.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', end);
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('contextmenu', menu);
    el.addEventListener('dragstart', nativeDrag);
    return () => {
      if (press) clearTimeout(press.timer);
      el.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', end);
      el.removeEventListener('touchmove', touchMove);
      el.removeEventListener('contextmenu', menu);
      el.removeEventListener('dragstart', nativeDrag);
    };
  }, [grid, enabled]);

  return enabled ? drag : null;
}
